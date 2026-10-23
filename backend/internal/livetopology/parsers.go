package livetopology

import (
	"encoding/xml"
	"fmt"
	"net"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type peer struct {
	Protocol   string
	Address    string
	FQDN       string
	Port       int
	PeerName   string
	SourceFile string
}

type parsedComponent struct {
	ComponentID string
	Listeners   []Endpoint
	Peers       []peer
	Identities  []string
	Files       []string
	Issues      []string
}

func (p *parsedComponent) merge(other *parsedComponent) {
	if p == nil || other == nil {
		return
	}
	p.Listeners = append(p.Listeners, other.Listeners...)
	p.Peers = append(p.Peers, other.Peers...)
	p.Identities = append(p.Identities, other.Identities...)
	p.Files = append(p.Files, other.Files...)
	p.Issues = append(p.Issues, other.Issues...)
}

var (
	portLinePattern    = regexp.MustCompile(`(?i)^port\s*=\s*(\d+)`)
	listenLinePattern  = regexp.MustCompile(`(?i)^listen\s*=\s*([a-z0-9]+):(.+):(\d+)\s*$`)
	connectPeerPattern = regexp.MustCompile(`(?i)^ConnectPeer\s*=\s*"([^"]+)"`)
	connectToPattern   = regexp.MustCompile(`(?i)^ConnectTo\s*=\s*"([^"]+)"`)
	identityPattern    = regexp.MustCompile(`(?i)^Identity\s*=\s*"([^"]+)"`)
	listenOnPattern    = regexp.MustCompile(`(?i)^ListenOn\s*=\s*"([^"]+)"`)
	draServerPort      = regexp.MustCompile(`(?i)^serverPort\s*=\s*(\d+)`)
	draHTTP2Port       = regexp.MustCompile(`(?i)^http2Port\s*=\s*(\d+)`)
	draMMLPort         = regexp.MustCompile(`(?i)^mmlPort\s*=\s*(\d+)`)
	draRealm           = regexp.MustCompile(`(?i)^realm\s*=\s*"([^"]+)"`)
)

func defaultPort(protocol string) int {
	switch protocol {
	case "sbi":
		return 7777
	case "pfcp":
		return 8805
	case "gtpc":
		return 2123
	case "gtpu":
		return 2152
	case "diameter":
		return 3868
	case "sip":
		return 5060
	default:
		return 0
	}
}

func parseConfigFile(componentID, path string, data []byte) (*parsedComponent, error) {
	base := filepath.Base(path)
	lower := strings.ToLower(base)
	ext := strings.ToLower(filepath.Ext(lower))
	parsed := &parsedComponent{ComponentID: componentID, Files: []string{base}}
	switch {
	case ext == ".yaml" || ext == ".yml":
		parseOpen5GSYAML(parsed, data, base)
	case ext == ".conf":
		parseFreeDiameter(parsed, data, base)
	case ext == ".xml":
		if err := parseDiameterXML(parsed, data, base); err != nil {
			return nil, err
		}
	case ext == ".cfg":
		if componentID == "dra" {
			parseDRAConfig(parsed, data, base)
		} else {
			parseSIPConfig(parsed, data, base)
		}
	case ext == ".properties":
		// HSS properties carry web/session settings, not NF peer topology.
	default:
		return nil, fmt.Errorf("unsupported config file type %q", ext)
	}
	return parsed, nil
}

func stripYAMLComment(line string) string {
	// Deployment YAML values never contain '#' in this surface; a conservative
	// cut keeps the parser bounded and avoids interpreting commented examples.
	if index := strings.Index(line, "#"); index >= 0 {
		line = line[:index]
	}
	return line
}

func leadingSpaces(line string) int {
	return len(line) - len(strings.TrimLeft(line, " "))
}

func unquote(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 {
		if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
			return value[1 : len(value)-1]
		}
	}
	return value
}

func isProtocol(key string) bool {
	switch key {
	case "sbi", "pfcp", "gtpc", "gtpu":
		return true
	default:
		return false
	}
}

func parseOpen5GSYAML(parsed *parsedComponent, data []byte, sourceFile string) {
	protocol := ""
	mode := ""
	hint := ""
	var current *Endpoint
	var currentPeer *peer
	setCurrentPort := func(port int) {
		if current != nil {
			current.Port = port
		}
		if currentPeer != nil {
			currentPeer.Port = port
		}
	}
	for _, raw := range strings.Split(string(data), "\n") {
		line := stripYAMLComment(strings.TrimRight(raw, "\r"))
		if strings.TrimSpace(line) == "" {
			continue
		}
		indent := leadingSpaces(line)
		trim := strings.TrimSpace(line)
		switch {
		case indent == 0:
			protocol, mode, hint, current, currentPeer = "", "", "", nil, nil
		case indent == 2:
			current, currentPeer = nil, nil
			hint = ""
			mode = ""
			protocol = ""
			key := strings.TrimSuffix(trim, ":")
			if isProtocol(key) {
				protocol = key
			}
		case indent == 4:
			current, currentPeer = nil, nil
			hint = ""
			switch trim {
			case "server:":
				mode = "server"
			case "client:":
				mode = "client"
			default:
				mode = ""
			}
		case mode == "client" && indent == 6 && strings.HasSuffix(trim, ":") && !strings.HasPrefix(trim, "-"):
			hint = strings.TrimSuffix(trim, ":")
			current, currentPeer = nil, nil
		case strings.HasPrefix(trim, "- address:"):
			if protocol == "" || mode == "" {
				continue
			}
			address := unquote(strings.TrimSpace(strings.TrimPrefix(trim, "- address:")))
			if address == "" {
				continue
			}
			if mode == "server" {
				parsed.Listeners = append(parsed.Listeners, Endpoint{
					Protocol: protocol, Address: address, SourceFile: sourceFile,
				})
				current = &parsed.Listeners[len(parsed.Listeners)-1]
				currentPeer = nil
			} else {
				parsed.Peers = append(parsed.Peers, peer{
					Protocol: protocol, Address: address, PeerName: hint, SourceFile: sourceFile,
				})
				currentPeer = &parsed.Peers[len(parsed.Peers)-1]
				current = nil
			}
		case strings.HasPrefix(trim, "address:"):
			if protocol == "" || mode == "" {
				continue
			}
			address := unquote(strings.TrimSpace(strings.TrimPrefix(trim, "address:")))
			if address == "" {
				continue
			}
			if mode == "server" {
				parsed.Listeners = append(parsed.Listeners, Endpoint{Protocol: protocol, Address: address, SourceFile: sourceFile})
				current = &parsed.Listeners[len(parsed.Listeners)-1]
				currentPeer = nil
			}
		case strings.HasPrefix(trim, "port:"):
			value := strings.TrimSpace(strings.TrimPrefix(trim, "port:"))
			port, err := strconv.Atoi(value)
			if err == nil && port > 0 && port <= 65535 {
				setCurrentPort(port)
			}
		}
	}
	for index := range parsed.Listeners {
		if parsed.Listeners[index].Port == 0 {
			parsed.Listeners[index].Port = defaultPort(parsed.Listeners[index].Protocol)
		}
	}
	for index := range parsed.Peers {
		if parsed.Peers[index].Port == 0 {
			parsed.Peers[index].Port = defaultPort(parsed.Peers[index].Protocol)
		}
	}
}

func parseFreeDiameter(parsed *parsedComponent, data []byte, sourceFile string) {
	var listen []string
	port := 0
	inConnect := false
	var peerFQDN string
	peerPort := 0
	connectTo := ""
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(strings.SplitN(raw, "#", 2)[0])
		if line == "" {
			continue
		}
		if inConnect {
			if strings.HasPrefix(line, "}") {
				if peerFQDN != "" {
					parsed.Peers = append(parsed.Peers, peer{
						Protocol: "diameter", FQDN: peerFQDN, Address: connectTo,
						Port: peerPort, SourceFile: sourceFile,
					})
				}
				inConnect, peerFQDN, peerPort, connectTo = false, "", 0, ""
				continue
			}
			if match := portLinePattern.FindStringSubmatch(line); len(match) == 2 {
				peerPort, _ = strconv.Atoi(match[1])
			}
			if match := connectToPattern.FindStringSubmatch(line); len(match) == 2 {
				connectTo = match[1]
			}
			continue
		}
		if match := connectPeerPattern.FindStringSubmatch(line); len(match) == 2 {
			peerFQDN = match[1]
			if strings.Contains(line, "{") {
				inConnect = true
			} else {
				parsed.Peers = append(parsed.Peers, peer{
					Protocol: "diameter", FQDN: peerFQDN, SourceFile: sourceFile,
				})
			}
			continue
		}
		if match := identityPattern.FindStringSubmatch(line); len(match) == 2 {
			parsed.Identities = append(parsed.Identities, match[1])
			continue
		}
		if match := listenOnPattern.FindStringSubmatch(line); len(match) == 2 {
			listen = append(listen, match[1])
			continue
		}
		if match := portLinePattern.FindStringSubmatch(line); len(match) == 2 {
			value, err := strconv.Atoi(match[1])
			if err == nil && value > 0 && value <= 65535 {
				port = value
			}
		}
	}
	if port == 0 {
		port = defaultPort("diameter")
	}
	for _, address := range listen {
		if strings.TrimSpace(address) == "" {
			continue
		}
		parsed.Listeners = append(parsed.Listeners, Endpoint{
			Protocol: "diameter", Address: address, Port: port, SourceFile: sourceFile,
		})
	}
	for index := range parsed.Peers {
		if parsed.Peers[index].Port == 0 {
			parsed.Peers[index].Port = defaultPort("diameter")
		}
	}
}

type xmlDiameterPeer struct {
	FQDN    string `xml:"FQDN,attr"`
	Realm   string `xml:"Realm,attr"`
	Port    int    `xml:"port,attr"`
	SrcAddr string `xml:"src_addr,attr"`
}

type xmlDiameterAcceptor struct {
	Port int    `xml:"port,attr"`
	Bind string `xml:"bind,attr"`
}

type xmlDiameterPeerRoot struct {
	XMLName   xml.Name              `xml:"DiameterPeer"`
	FQDN      string                `xml:"FQDN,attr"`
	Realm     string                `xml:"Realm,attr"`
	Acceptors []xmlDiameterAcceptor `xml:"Acceptor"`
	Peers     []xmlDiameterPeer     `xml:"Peer"`
}

func parseDiameterXML(parsed *parsedComponent, data []byte, sourceFile string) error {
	var root xmlDiameterPeerRoot
	if err := xml.Unmarshal(data, &root); err != nil {
		return fmt.Errorf("Diameter XML is invalid: %w", err)
	}
	if strings.TrimSpace(root.FQDN) != "" {
		parsed.Identities = append(parsed.Identities, strings.TrimSpace(root.FQDN))
	}
	for _, acceptor := range root.Acceptors {
		if acceptor.Port <= 0 || acceptor.Port > 65535 || strings.TrimSpace(acceptor.Bind) == "" {
			continue
		}
		parsed.Listeners = append(parsed.Listeners, Endpoint{
			Protocol: "diameter", Address: strings.TrimSpace(acceptor.Bind),
			Port: acceptor.Port, SourceFile: sourceFile,
		})
	}
	for _, item := range root.Peers {
		if strings.TrimSpace(item.FQDN) == "" && strings.TrimSpace(item.SrcAddr) == "" {
			continue
		}
		parsed.Peers = append(parsed.Peers, peer{
			Protocol: "diameter", FQDN: strings.TrimSpace(item.FQDN),
			Address: strings.TrimSpace(item.SrcAddr), Port: item.Port,
			SourceFile: sourceFile,
		})
	}
	for index := range parsed.Peers {
		if parsed.Peers[index].Port == 0 {
			parsed.Peers[index].Port = defaultPort("diameter")
		}
	}
	return nil
}

func parseSIPConfig(parsed *parsedComponent, data []byte, sourceFile string) {
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(strings.SplitN(raw, "#", 2)[0])
		match := listenLinePattern.FindStringSubmatch(line)
		if len(match) != 4 {
			continue
		}
		address := strings.TrimSpace(match[2])
		if !isUsableAddress(address) {
			parsed.Issues = append(parsed.Issues, "SIP listener address is a variable or unresolved label")
			continue
		}
		port, err := strconv.Atoi(match[3])
		if err != nil || port <= 0 || port > 65535 {
			continue
		}
		parsed.Listeners = append(parsed.Listeners, Endpoint{
			Protocol: "sip", Address: address, Port: port, SourceFile: sourceFile,
		})
	}
}

func isUsableAddress(address string) bool {
	if address == "" || strings.ContainsAny(address, "$%{}") {
		return false
	}
	if net.ParseIP(address) != nil {
		return true
	}
	return strings.Contains(address, ".") && !strings.ContainsAny(address, " _")
}

func parseDRAConfig(parsed *parsedComponent, data []byte, sourceFile string) {
	var realm string
	ports := map[string]int{}
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(strings.SplitN(raw, "//", 2)[0])
		if line == "" {
			continue
		}
		if match := draServerPort.FindStringSubmatch(line); len(match) == 2 {
			ports["serverPort"], _ = strconv.Atoi(match[1])
		}
		if match := draHTTP2Port.FindStringSubmatch(line); len(match) == 2 {
			ports["http2Port"], _ = strconv.Atoi(match[1])
		}
		if match := draMMLPort.FindStringSubmatch(line); len(match) == 2 {
			ports["mmlPort"], _ = strconv.Atoi(match[1])
		}
		if match := draRealm.FindStringSubmatch(line); len(match) == 2 && realm == "" {
			realm = match[1]
		}
	}
	if realm != "" {
		// Realm is retained for parsing completeness only; a realm is not an NF
		// FQDN and must never be used to resolve another component's peer.
		parsed.Issues = append(parsed.Issues, "DRA realm parsed: "+realm)
	}
	addListener := func(protocol string, port int) {
		if port <= 0 {
			return
		}
		// The reference config names ports but no bind address. The port is
		// configured evidence; the address is deliberately left unknown.
		parsed.Listeners = append(parsed.Listeners, Endpoint{
			Protocol: protocol, Port: port, SourceFile: sourceFile,
		})
	}
	addListener("diameter", ports["serverPort"])
	addListener("http2", ports["http2Port"])
	addListener("mml", ports["mmlPort"])
	if len(ports) == 0 {
		parsed.Issues = append(parsed.Issues, "DRA config has no recognizable local ports")
	}
	// DRA is a proxy. Its configured peer segments are deliberately not
	// promoted to direct NF-to-NF edges.
}
