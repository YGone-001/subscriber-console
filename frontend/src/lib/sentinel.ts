import { emitSyslog, SyslogLevel } from './syslog';
import { AuditAction } from './audit';
import { appendAlert } from '@/server/repositories/alertRepository';
import { findSubscriberLegacyState, updateSubscriberFromLegacy } from '@/server/repositories/subscriberRepository';

export async function evaluateSecurityPolicies(action: AuditAction, oldTrafficObj: any, newTrafficObj: any) {
  try {
    if (!newTrafficObj) return;

    const oldBalance = Number(oldTrafficObj?.traffic_balance || 0);
    const newBalance = Number(newTrafficObj.traffic_balance || 0);
    const imsi = newTrafficObj.imsi;
    if (!imsi) return;

    let alertLevel: SyslogLevel | null = null;
    let reason = '';

    if (oldBalance > 0 && newBalance <= 0) {
      alertLevel = 'WARNING';
      reason = 'Traffic completely exhausted. Subscriber may experience service cut-off.';
    }

    const drop = oldBalance - newBalance;
    if (drop > 524288000) {
      alertLevel = 'CRITICAL';
      reason = `Massive traffic discharge detected (${(drop / 1048576).toFixed(0)} MB drop). Potential DDoS or abnormal leak!`;
    }

    if (!alertLevel) return;

    await appendAlert({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level: alertLevel,
      imsi,
      reason,
      is_acknowledged: false,
    });

    if (alertLevel === 'CRITICAL') {
      const state = await findSubscriberLegacyState(imsi);
      if (state?.sub4G) {
        await updateSubscriberFromLegacy(imsi, {
          ...state,
          sub4G: { ...state.sub4G, access_restriction_data: 2 },
        });
        await emitSyslog('CRITICAL', imsi, `[AUTO-DEFENSE] Subscriber ${imsi} suspended gracefully due to DDoS pattern.`);
      }
    }

    await emitSyslog(alertLevel, imsi, reason);
  } catch (error) {
    console.error('Sentinel engine evaluation failed:', error);
  }
}
