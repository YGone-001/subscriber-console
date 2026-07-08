import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_REPORT_DIR = 'reports/ops';

export function reportPath(commandName, startedAt = new Date()) {
  const safeTimestamp = startedAt.toISOString().replace(/[:.]/g, '-');
  return path.join(process.cwd(), process.env.OPS_REPORT_DIR || DEFAULT_REPORT_DIR, `${commandName}-${safeTimestamp}.json`);
}

export function errorSummary(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code,
    stack: error?.stack,
  };
}

export async function writeOpsReport(commandName, report, startedAt) {
  const outputPath = reportPath(commandName, startedAt);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outputPath;
}
