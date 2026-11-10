package configsnapshots

import (
	"context"
	"strings"
	"time"
)

func Compare(left, right *Snapshot) string {
	if left == nil || right == nil {
		return "no_baseline"
	}
	if left.SourceID != right.SourceID || left.Generation != right.Generation || left.Policy != right.Policy || left.KeyVersion != right.KeyVersion {
		return "incompatible"
	}
	if left.Fingerprint == right.Fingerprint {
		return "unchanged"
	}
	if left.Mode == "projected" && right.Mode == "projected" && left.ProjectionHash != right.ProjectionHash {
		return "visible_changed"
	}
	return "unprojected_changed"
}

func BuildDiff(ctx context.Context, left, right *Snapshot) Diff {
	out := Diff{Left: left, Right: right, Comparison: Compare(left, right), Lines: []DiffLine{}}
	if out.Comparison == "incompatible" || left == nil || right == nil {
		out.Reason = "incompatible_versions"
		return out
	}
	if left.Mode != "projected" || right.Mode != "projected" {
		out.Reason = "metadata_only"
		return out
	}
	a, b := strings.Split(strings.TrimSuffix(left.Projection, "\n"), "\n"), strings.Split(strings.TrimSuffix(right.Projection, "\n"), "\n")
	if len(a) > 5000 || len(b) > 5000 {
		out.Reason = "line_budget_exceeded"
		return out
	}
	deadline := time.Now().Add(2 * time.Second)
	add := func(kind, text string, l, r int) {
		var lp, rp *int
		if l > 0 {
			x := l
			lp = &x
		}
		if r > 0 {
			x := r
			rp = &x
		}
		out.Lines = append(out.Lines, DiffLine{kind, lp, rp, text})
	}
	prefix := 0
	for prefix < len(a) && prefix < len(b) && a[prefix] == b[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(a)-prefix && suffix < len(b)-prefix && a[len(a)-1-suffix] == b[len(b)-1-suffix] {
		suffix++
	}
	x, y := a[prefix:len(a)-suffix], b[prefix:len(b)-suffix]
	if (len(x)+1)*(len(y)+1) > 2000000 {
		out.Reason = "comparison_budget_exceeded"
		return out
	}
	w := len(y) + 1
	dp := make([]uint16, (len(x)+1)*w)
	for i := len(x) - 1; i >= 0; i-- {
		if ctx.Err() != nil || time.Now().After(deadline) {
			out.Reason = "comparison_budget_exceeded"
			return out
		}
		for j := len(y) - 1; j >= 0; j-- {
			if x[i] == y[j] {
				dp[i*w+j] = dp[(i+1)*w+j+1] + 1
			} else {
				v := dp[(i+1)*w+j]
				if dp[i*w+j+1] > v {
					v = dp[i*w+j+1]
				}
				dp[i*w+j] = v
			}
		}
	}
	for i := 0; i < prefix; i++ {
		add("same", a[i], i+1, i+1)
	}
	i, j := 0, 0
	for i < len(x) || j < len(y) {
		if i < len(x) && j < len(y) && x[i] == y[j] {
			add("same", x[i], prefix+i+1, prefix+j+1)
			i++
			j++
		} else if j < len(y) && (i == len(x) || dp[i*w+j+1] > dp[(i+1)*w+j]) {
			add("add", y[j], 0, prefix+j+1)
			j++
		} else {
			add("remove", x[i], prefix+i+1, 0)
			i++
		}
	}
	for k := suffix; k > 0; k-- {
		add("same", a[len(a)-k], len(a)-k+1, len(b)-k+1)
	}
	out.Complete = true
	return out
}
