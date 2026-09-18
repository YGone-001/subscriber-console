import { AuditAction } from './audit';
import { evaluateSecurityPolicies } from './sentinel';

export async function updateAnalytics(action: AuditAction, oldVal: any, newVal: any) {
  try {
    if (action !== 'CREATE' && action !== 'UPDATE' && action !== 'DELETE') return;

    const oldTrafficObj = oldVal?.ocsTraffic || oldVal?.traffic;
    const newTrafficObj = newVal?.ocsTraffic || newVal?.traffic;
    const oldBalance = oldTrafficObj ? Number(oldTrafficObj.traffic_balance || 0) : 0;
    const newBalance = newTrafficObj ? Number(newTrafficObj.traffic_balance || 0) : 0;

    if (oldBalance !== newBalance) {
      await evaluateSecurityPolicies(action, oldTrafficObj, newTrafficObj);
    }
  } catch (error) {
    console.error('Analytics event hook failed:', error);
  }
}
