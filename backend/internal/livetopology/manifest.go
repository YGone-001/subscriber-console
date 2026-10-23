package livetopology

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	manifestMaxBytes = 256 * 1024
	configMaxBytes   = 1024 * 1024
	maxComponents    = 64
	maxFilesPerComp  = 16
	maxSourceFiles   = 128
	maxIssues        = 64
)

// Loader reads the operator-owned manifest and the config files it names.
//
// The manifest is the only path authority. No default root, reference copy or
// host-specific path is assumed here.
type Loader struct {
	ManifestPath string
}

func NewLoader(manifestPath string) *Loader {
	return &Loader{ManifestPath: strings.TrimSpace(manifestPath)}
}

type Manifest map[string][]string

func loadManifest(path string) (Manifest, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("NF_ETC_MANIFEST must be an absolute path")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, errors.New("manifest is not readable")
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("manifest is not a regular file")
	}
	if info.Size() > manifestMaxBytes {
		return nil, fmt.Errorf("manifest exceeds %d bytes", manifestMaxBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("manifest read failed")
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("manifest JSON is invalid: %w", err)
	}
	if len(manifest) == 0 {
		return nil, errors.New("manifest contains no component sources")
	}
	if len(manifest) > maxComponents {
		return nil, fmt.Errorf("manifest exceeds %d components", maxComponents)
	}
	for componentID, files := range manifest {
		if strings.TrimSpace(componentID) == "" {
			return nil, errors.New("manifest contains an empty component id")
		}
		if len(files) == 0 || len(files) > maxFilesPerComp {
			return nil, fmt.Errorf("component %s must name 1..%d config files", componentID, maxFilesPerComp)
		}
		for _, file := range files {
			if !filepath.IsAbs(strings.TrimSpace(file)) {
				return nil, fmt.Errorf("component %s has a non-absolute config path", componentID)
			}
		}
	}
	return manifest, nil
}

func readConfigFile(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, errors.New("config file is not readable")
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("config path is not a regular file")
	}
	if info.Size() > configMaxBytes {
		return nil, fmt.Errorf("config file exceeds %d bytes", configMaxBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("config file read failed")
	}
	return data, nil
}

// Load reads every manifest source. Missing or malformed individual files are
// reported per source; they never hide runtime nodes or fail the whole call.
func (l *Loader) Load(runtimeIDs map[string]bool) (map[string]*parsedComponent, ConfigStatus) {
	status := ConfigStatus{ManifestConfigured: l != nil && l.ManifestPath != ""}
	if l == nil || l.ManifestPath == "" {
		status.Unavailable = append(status.Unavailable, UnavailableSource{
			Reason: "NF_ETC_MANIFEST is not configured",
		})
		return map[string]*parsedComponent{}, status
	}
	manifest, err := loadManifest(l.ManifestPath)
	if err != nil {
		status.Unavailable = append(status.Unavailable, UnavailableSource{Reason: err.Error()})
		return map[string]*parsedComponent{}, status
	}

	componentIDs := make([]string, 0, len(manifest))
	for componentID := range manifest {
		componentIDs = append(componentIDs, componentID)
	}
	sort.Strings(componentIDs)

	result := make(map[string]*parsedComponent, len(manifest))
	for _, componentID := range componentIDs {
		files := manifest[componentID]
		if runtimeIDs != nil && !runtimeIDs[componentID] {
			status.Unavailable = append(status.Unavailable, UnavailableSource{
				ComponentID: componentID,
				Reason:      "component is not present in the runtime registry",
			})
			continue
		}
		parsed := &parsedComponent{ComponentID: componentID}
		for _, file := range files {
			if status.SourceCount >= maxSourceFiles {
				status.Unavailable = append(status.Unavailable, UnavailableSource{
					ComponentID: componentID,
					File:        filepath.Base(file),
					Reason:      "source file limit reached",
				})
				continue
			}
			status.SourceCount++
			data, readErr := readConfigFile(file)
			if readErr != nil {
				status.Unavailable = append(status.Unavailable, UnavailableSource{
					ComponentID: componentID,
					File:        filepath.Base(file),
					Reason:      readErr.Error(),
				})
				continue
			}
			parsedFile, parseErr := parseConfigFile(componentID, file, data)
			if parseErr != nil {
				status.Unavailable = append(status.Unavailable, UnavailableSource{
					ComponentID: componentID,
					File:        filepath.Base(file),
					Reason:      parseErr.Error(),
				})
				continue
			}
			status.AvailableSources++
			parsed.merge(parsedFile)
		}
		result[componentID] = parsed
	}
	if len(status.Unavailable) > maxIssues {
		status.Unavailable = status.Unavailable[:maxIssues]
	}
	status.Complete = len(status.Unavailable) == 0
	return result, status
}
