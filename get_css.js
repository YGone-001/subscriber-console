const fs = require('fs');

function extract(inFile, marker, outFile) {
  const content = fs.readFileSync(inFile, 'utf-8');
  const startIdx = content.indexOf(marker);
  if (startIdx === -1) {
    console.log(`Marker not found in ${inFile}`);
    return;
  }
  const cssStart = startIdx + marker.length;
  const cssEnd = content.indexOf('`;', cssStart);
  if (cssEnd !== -1) {
    const css = content.substring(cssStart, cssEnd);
    fs.writeFileSync(outFile, css);
    console.log(`Wrote CSS to ${outFile}`);
  }
}

extract('old_analytics.tsx', 'const analyticsStyles = `\n', 'src/components/analytics.css');
