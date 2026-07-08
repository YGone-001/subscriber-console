import dgram from 'dgram';

export type SyslogLevel = 'CRITICAL' | 'WARNING' | 'INFO';

const PRIORITY_MAP: Record<SyslogLevel, number> = {
  // Facility 16 (Local use 0) + Severity
  CRITICAL: 130, // 16*8 + 2 (Critical)
  WARNING: 132,  // 16*8 + 4 (Warning)
  INFO: 134      // 16*8 + 6 (Info)
};

/**
 * 纯内网异步隔离 Syslog 广播器
 * 不使用任何外部 npm 包，遵从 RFC 5424.
 * 静默消化所有网络层异常，严格保证不阻塞业务流。
 */
export async function emitSyslog(level: SyslogLevel, imsi: string, message: string) {
  setTimeout(() => {
    try {
      // 在隔离环境中，通常固定向 127.0.0.1 或内网集中器 514 端口倾倒
      const SYSLOG_HOST = process.env.SYSLOG_HOST || '127.0.0.1';
      const SYSLOG_PORT = parseInt(process.env.SYSLOG_PORT || '514', 10);

      const client = dgram.createSocket('udp4');
      const timestamp = new Date().toISOString();
      const hostname = 'xcloud-node';
      const appName = 'Sentinel';
      const procId = process.pid;
      const msgId = `IMSI-${imsi || 'SYS'}`;

      const pri = PRIORITY_MAP[level] || 134;

      // RFC 5424 Format: <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [SD-ID] MSG
      const packet = `<${pri}>1 ${timestamp} ${hostname} ${appName} ${procId} ${msgId} - ${message}`;

      const messageBuffer = Buffer.from(packet, 'utf8');

      client.send(messageBuffer, 0, messageBuffer.length, SYSLOG_PORT, SYSLOG_HOST, (err) => {
        if (err) {
          console.error('[Syslog Silent Error]:', err);
        }
        client.close();
      });
    } catch {
      // Drop packet entirely
    }
  }, 0);
}
