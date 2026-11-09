//go:build !linux

package agents

// Unsupported host measurements remain unavailable rather than fabricated.
func readHostCounters() hostCounters { return hostCounters{} }
