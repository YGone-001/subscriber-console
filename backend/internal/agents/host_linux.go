//go:build linux

package agents

import (
	"bufio"
	"io"
	"math"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func readProc(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 1024*1024+1))
	if err != nil || len(b) > 1024*1024 {
		return ""
	}
	return string(b)
}
func readHostCounters() hostCounters {
	var out hostCounters
	stat := strings.SplitN(readProc("/proc/stat"), "\n", 2)[0]
	fields := strings.Fields(stat)
	if len(fields) >= 5 && fields[0] == "cpu" {
		good := true
		for i := 1; i < len(fields) && i <= 8; i++ {
			v, err := strconv.ParseUint(fields[i], 10, 64)
			if err != nil {
				good = false
				break
			}
			out.TotalCPU += v
			if i == 4 || i == 5 {
				out.IdleCPU += v
			}
		}
		out.CPUValid = good
	}
	mem := map[string]int64{}
	scanner := bufio.NewScanner(strings.NewReader(readProc("/proc/meminfo")))
	for scanner.Scan() {
		row := strings.Fields(scanner.Text())
		if len(row) != 3 || row[2] != "kB" {
			continue
		}
		if row[0] != "MemTotal:" && row[0] != "MemAvailable:" {
			continue
		}
		n, err := strconv.ParseInt(row[1], 10, 64)
		if err == nil && n >= 0 && n <= math.MaxInt64/1024 {
			mem[row[0]] = n * 1024
		}
	}
	if v, ok := mem["MemTotal:"]; ok {
		out.Metrics.MemoryTotalBytes = &v
	}
	if v, ok := mem["MemAvailable:"]; ok && out.Metrics.MemoryTotalBytes != nil && v <= *out.Metrics.MemoryTotalBytes {
		out.Metrics.MemoryAvailableBytes = &v
	}
	if parts := strings.Fields(readProc("/proc/uptime")); len(parts) > 0 {
		v, err := strconv.ParseFloat(parts[0], 64)
		if err == nil && v >= 0 && !math.IsNaN(v) && !math.IsInf(v, 0) {
			out.Metrics.UptimeSeconds = &v
		}
	}
	var disk syscall.Statfs_t
	if syscall.Statfs("/", &disk) == nil && disk.Bsize > 0 {
		block := uint64(disk.Bsize)
		if disk.Blocks <= 9007199254740991/block && disk.Bavail <= disk.Blocks {
			total := int64(disk.Blocks * block)
			available := int64(disk.Bavail * block)
			out.Metrics.DiskTotalBytes = &total
			out.Metrics.DiskAvailableBytes = &available
		}
	}
	return out
}
