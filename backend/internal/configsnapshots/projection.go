package configsnapshots

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

var componentKeys = wordSet("amf ausf bsf hss mme nrf nssf pcf pcrf scp sepp smf sgwc sgwu upf udm udr")
var containerKeys = wordSet("sbi server client ngap s1ap gtpc gtpu pfcp metrics nrf scp smf amf upf mme sgwc sgwu ausf udm udr pcf bsf hss pcrf nssf session address bind advertise nghttp2")
var hostPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
var interfacePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,31}$`)

func wordSet(s string) map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(s) {
		m[w] = true
	}
	return m
}

// Projection is a positive allowlist, not a generic secret-name blacklist.
// Values, comments and unknown key names never appear in diagnostics.
func Projection(data []byte, format, profile string) (string, string, string) {
	if profile == "metadata-only-v1" || format == "diameter_conf" || format == "text" {
		return "metadata_only", "profile_metadata_only", ""
	}
	if format == "json" && !json.Valid(data) {
		return "metadata_only", "invalid_document", ""
	}
	var doc yaml.Node
	d := yaml.NewDecoder(bytes.NewReader(data))
	if d.Decode(&doc) != nil || d.Decode(new(yaml.Node)) != io.EOF {
		return "metadata_only", "invalid_document", ""
	}
	budget := 20000
	if !safeTree(&doc, 0, &budget) || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return "metadata_only", "unsupported_structure", ""
	}
	flat := map[string]any{}
	root := doc.Content[0]
	for i := 0; i < len(root.Content); i += 2 {
		key := root.Content[i].Value
		if componentKeys[key] {
			projectNode(root.Content[i+1], key, flat)
		}
		if key == "logger" {
			n := root.Content[i+1]
			if n.Kind == yaml.MappingNode {
				for j := 0; j < len(n.Content); j += 2 {
					if n.Content[j].Value == "level" && wordSet("fatal error warn info debug trace")[n.Content[j+1].Value] {
						flat["logger.level"] = n.Content[j+1].Value
					}
				}
			}
		}
	}
	if len(flat) == 0 {
		return "metadata_only", "no_approved_fields", ""
	}
	b, err := json.MarshalIndent(flat, "", "  ")
	if err != nil || len(b) > MaxProjectionBytes {
		return "metadata_only", "projection_too_large", ""
	}
	return "projected", "allowlisted_network_fields", string(b) + "\n"
}

func safeTree(n *yaml.Node, depth int, budget *int) bool {
	*budget--
	if depth > 32 || *budget < 0 || n.Kind == yaml.AliasNode || n.Anchor != "" || n.Tag == "!!merge" {
		return false
	}
	if n.Tag != "" && n.Tag != "!!map" && n.Tag != "!!seq" && n.Tag != "!!str" && n.Tag != "!!int" && n.Tag != "!!float" && n.Tag != "!!bool" && n.Tag != "!!null" {
		return false
	}
	if n.Kind == yaml.MappingNode {
		seen := map[string]bool{}
		for i := 0; i < len(n.Content); i += 2 {
			k := n.Content[i]
			if k.Kind != yaml.ScalarNode || k.Tag != "!!str" || seen[k.Value] {
				return false
			}
			seen[k.Value] = true
		}
	}
	for _, child := range n.Content {
		if !safeTree(child, depth+1, budget) {
			return false
		}
	}
	return true
}
func projectNode(n *yaml.Node, path string, out map[string]any) {
	if n.Kind == yaml.SequenceNode {
		for i, c := range n.Content {
			projectNode(c, fmt.Sprintf("%s[%d]", path, i), out)
		}
		return
	}
	if n.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i < len(n.Content); i += 2 {
		key, value := n.Content[i].Value, n.Content[i+1]
		p := path + "." + key
		if value.Kind == yaml.ScalarNode {
			if v, ok := approvedScalar(key, value.Value); ok {
				out[p] = v
			}
		} else if containerKeys[key] {
			projectNode(value, p, out)
		}
	}
}
func approvedScalar(key, value string) (any, bool) {
	if len(value) > 253 || strings.ContainsAny(value, "\r\n\t") {
		return nil, false
	}
	switch key {
	case "address", "addr", "advertise", "bind":
		if _, err := netip.ParseAddr(value); err == nil {
			return value, true
		}
		return value, hostPattern.MatchString(value)
	case "port":
		v, e := strconv.Atoi(value)
		return v, e == nil && v > 0 && v <= 65535
	case "scheme":
		return value, value == "http" || value == "https"
	case "uri":
		u, e := url.Parse(value)
		return value, e == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && (u.Path == "" || u.Path == "/")
	case "subnet":
		_, e := netip.ParsePrefix(value)
		return value, e == nil
	case "dev":
		return value, interfacePattern.MatchString(value)
	case "dnn":
		return value, hostPattern.MatchString(value)
	}
	return nil, false
}
