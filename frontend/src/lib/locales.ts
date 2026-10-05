/*
 * Translation dictionaries.
 *
 * Two sources are merged here:
 *   1. The reference dictionaries (`./locales/en`, `./locales/zh`, ~2200 keys
 *      each), forward-ported from the historical xCloud UI. These are
 *      authoritative and supply the reference wording for shared keys.
 *   2. `LEGACY_*` below: the keys the earlier hand-written shell/business layer
 *      introduced that the reference dictionaries do not define. They only fill
 *      gaps, so no existing call site regresses.
 *
 * Precedence: reference dictionary wins; the legacy map is a fallback.
 */
import type { Locale } from './preferences';
import { en as referenceEn } from './locales/en';
import { zh as referenceZh } from './locales/zh';

export interface LocaleMeta {
  code: Locale;
  name: string;
  nativeName: string;
  htmlLang: string;
  intlLocale: string;
}

export const SUPPORTED_LOCALES: LocaleMeta[] = [
  { code: 'en', name: 'English', nativeName: 'English', htmlLang: 'en', intlLocale: 'en-US' },
  { code: 'zh', name: 'Chinese', nativeName: '简体中文', htmlLang: 'zh-CN', intlLocale: 'zh-CN' },
];

export const DEFAULT_LOCALE: Locale = 'en';

const LEGACY_EN: Record<string, string> = {
  skip_to_content: 'Skip to content', brand_tagline: 'Subscriber console', sign_in: 'Sign in',
  username: 'Username', password: 'Password', show_password: 'Show password', hide_password: 'Hide password',
  signing_in: 'Signing in...', session_expired: 'Your session has expired. Please sign in again.',
  invalid_credentials: 'Invalid credentials.', rate_limited: 'Too many attempts. Retry after {seconds} seconds.',
  auth_unavailable: 'Authentication service is unavailable.', retry: 'Retry', logout: 'Sign out',
  theme: 'Theme', language: 'Language', system: 'System', light: 'Light', dark: 'Dark',
  navigation: 'Navigation', search_navigation: 'Search navigation', command_palette: 'Command palette',
  close: 'Close', menu: 'Menu', collapse_sidebar: 'Collapse sidebar', expand_sidebar: 'Expand sidebar',
  not_found_title: 'Page not found', not_found_body: 'The requested console route does not exist or is not available to your role.',
  pending_title: 'This page is queued for migration', pending_body: 'The shared shell is ready; this business page has not moved yet.',
  home_title: 'Shared SPA shell', home_body: 'Navigation, appearance, and session handling are ready for the next page migrations.',
  breadcrumbs_home: 'Home', nav_dashboard: 'Dashboard', nav_subscribers: 'Subscribers', nav_ocs: 'Online charging',
  nav_tariffs: 'Tariff plans', nav_contracts: 'Contracts', nav_balances: 'Balances', nav_profile: 'Profiles',
  nav_rating: 'Rating', nav_users: 'Users', nav_health: 'System health', nav_roles: 'Roles',
  nav_ocs_dashboard: 'OCS dashboard', nav_ocs_sessions: 'OCS sessions', nav_ocs_subscribers: 'OCS subscribers',
  nav_ocs_usage: 'OCS usage', nav_rating_plans: 'Rating plans', nav_rating_rules: 'Rating rules',
  nav_user_create: 'Create user', unavailable_title: 'Session authority unavailable',
  unavailable_body: 'The application cannot verify your session at the moment.', account: 'Account',
  read_only_parity: 'Read-only migration parity', loading: 'Loading...', empty: 'No data is available.', refresh: 'Refresh',
  read_table: 'Read-only results', details: 'Details', search: 'Search', records: 'records', previous: 'Previous', next: 'Next',
  back: 'Back', export: 'Export', traffic_trend: 'Traffic trend', workbench: 'Operational priorities',
  nav_inventory: 'Inventory', nav_inventory_create: 'Create resource', inventory_title: 'Inventory',
  inventory_resource: 'Resource', inventory_kind: 'Kind', inventory_domain: 'Domain', inventory_role: 'Role',
  inventory_lifecycle: 'Lifecycle', inventory_vendor: 'Vendor', inventory_model: 'Model', inventory_software: 'Software',
  inventory_management_endpoint: 'Management Endpoint', inventory_capabilities: 'Capabilities',
  inventory_labels: 'Labels', inventory_attributes: 'Attributes', inventory_source: 'Source', inventory_revision: 'Revision',
  inventory_create_resource: 'Create Resource', inventory_edit_resource: 'Edit Resource', inventory_retire_resource: 'Retire Resource',
  inventory_name: 'Name', inventory_updated_at: 'Updated At', saving: 'Saving...', retire: 'Retire',
  brand_alt: 'xCloud trademark', clear: 'Clear', breadcrumbs_label: 'Breadcrumb',
  role_admin: 'Administrator', role_operator: 'Operator', role_viewer: 'Viewer', role_unknown: 'Unknown role',
  account_settings: 'Account settings', nav_system_settings: 'System settings',
  sidebar_filter_ph: 'Filter menu...', sidebar_collapse_hint: 'Collapse navigation sidebar (Ctrl+B)',
  sidebar_expand_hint: 'Expand navigation sidebar (Ctrl+B)',
  notif_center_title: 'Notification center', notif_live_stream: 'Live stream',
  notif_stream_live: 'Live', notif_stream_reconnecting: 'Reconnecting', notif_tab_all: 'All',
  notif_tab_alerts: 'Alerts', notif_tab_system: 'System', notif_empty: 'No notifications yet.',
  notif_mark_all_read: 'Mark all as read', notif_clear_all: 'Clear all', notif_view_details: 'View details',
  noc_sentinel: 'Sentinel', noc_all_clear: 'All clear', noc_all_clear_body: 'No active alerts are being reported.',
  noc_unavailable: 'Unavailable', noc_unavailable_body: 'The alert stream is not connected, so no operational posture is asserted.',
  noc_alerts_active: '{count} active', noc_critical: 'Critical', noc_warning: 'Warning', noc_total: 'Total',
  alert_acknowledged: 'Acknowledged', alert_open: 'Open',
  cp_navigation: 'Navigation', cp_action: 'Action', cp_no_results: 'No matching destinations.',
  cp_hint_navigate: 'Navigate', cp_hint_select: 'Select',
  dashboard_eyebrow: 'Operational cockpit', dashboard_live: 'Live', dashboard_stale: 'Stale',
  dashboard_offline: 'Offline', dashboard_generated_at: 'Snapshot {time}',
  dashboard_traffic_trend: 'Traffic trend', dashboard_subscriber_trend: 'Subscriber trend',
  dashboard_plmn_distribution: 'PLMN distribution', dashboard_tariff_distribution: 'Tariff plan distribution',
  dashboard_top_consumers: 'Top data consumers', dashboard_ocs_balances: 'OCS balance capacity',
  dashboard_ocs_sessions: 'OCS session telemetry', dashboard_ocs_reservations: 'OCS reservations',
  dashboard_ocs_usage: 'OCS usage records', dashboard_kpi_traffic: 'Total traffic',
  dashboard_kpi_subscribers: 'Subscribers', dashboard_kpi_alerts: 'Active alerts',
  dashboard_kpi_contracts: 'OCS contracts', dashboard_kpi_active_sessions: 'Active sessions',
  dashboard_kpi_utilization: 'Data utilization', dashboard_kpi_invariants: 'Balance invariants',
  dashboard_workbench: 'Operational priorities', dashboard_workbench_empty: 'No urgent work items',
  dashboard_workbench_empty_body: 'No unacknowledged alerts are currently reported by the alert authority.',
  dashboard_unavailable: 'Metric unavailable', dashboard_unavailable_body: 'This metric is not reported by the current API contract.',
  dashboard_no_series: 'No series reported', dashboard_no_series_body: 'The current API contract returned no data points for this chart.',
  dashboard_invariants_ok: 'All balance invariants hold', dashboard_invariants_broken: '{count} broken invariants',
  dashboard_allocated: 'Allocated', dashboard_used: 'Used', dashboard_available: 'Available', dashboard_reserved: 'Reserved',
  dashboard_sessions_total: 'Total sessions', dashboard_sessions_active: 'Active', dashboard_sessions_closed: 'Closed',
  dashboard_gy_ro: 'Gy / Ro interfaces', dashboard_records: 'Records', dashboard_charged_records: 'Charged',
  dashboard_orphaned_reservations: 'Orphaned', dashboard_settled_reservations: 'Settled',
  error_title: 'Request failed', loading_data: 'Loading operational data...',
  empty_title: 'Nothing to show', empty_generic_body: 'The current API contract returned no rows for this view.',
  unit_bytes: 'B', unit_records: 'records', unit_sessions: 'sessions', unit_percent: '%',
  inventory_empty_body: 'No inventory resources match the current filters.',
  inventory_loading_body: 'Loading inventory resources...',
};

const LEGACY_ZH: Record<string, string> = {
  skip_to_content: '跳至主要内容', brand_tagline: '用户控制台', sign_in: '登录', username: '用户名', password: '密码',
  show_password: '显示密码', hide_password: '隐藏密码', signing_in: '正在登录...', session_expired: '会话已过期，请重新登录。',
  invalid_credentials: '凭据无效。', rate_limited: '尝试次数过多，请在 {seconds} 秒后重试。', auth_unavailable: '认证服务暂时不可用。',
  retry: '重试', logout: '退出登录', theme: '主题', language: '语言', system: '跟随系统', light: '浅色', dark: '深色',
  navigation: '导航', search_navigation: '搜索导航', command_palette: '命令面板', close: '关闭', menu: '菜单',
  collapse_sidebar: '收起侧边栏', expand_sidebar: '展开侧边栏', not_found_title: '未找到页面',
  not_found_body: '请求的控制台路由不存在，或您的角色无权访问。', pending_title: '此页面等待迁移',
  pending_body: '共享界面已就绪；该业务页面尚未迁移。', home_title: '共享 SPA 外壳',
  home_body: '导航、外观和会话处理已为后续页面迁移准备就绪。', breadcrumbs_home: '首页', nav_dashboard: '仪表盘',
  nav_subscribers: '用户', nav_ocs: '在线计费', nav_tariffs: '资费套餐', nav_contracts: '合约', nav_balances: '余额',
  nav_profile: '配置文件', nav_rating: '计费规则', nav_users: '用户管理', nav_health: '系统健康', nav_roles: '角色',
  nav_ocs_dashboard: 'OCS 仪表盘', nav_ocs_sessions: 'OCS 会话', nav_ocs_subscribers: 'OCS 用户', nav_ocs_usage: 'OCS 用量',
  nav_rating_plans: '计费套餐', nav_rating_rules: '计费规则', nav_user_create: '创建用户',
  unavailable_title: '会话认证不可用', unavailable_body: '应用当前无法验证您的会话。', account: '账户',
  read_only_parity: '只读迁移一致性', loading: '加载中...', empty: '暂无可用数据。', refresh: '刷新',
  read_table: '只读结果', details: '详情', search: '搜索', records: '条记录', previous: '上一页', next: '下一页',
  back: '返回', export: '导出', traffic_trend: '流量趋势', workbench: '运营优先事项',
  nav_inventory: '资源清单', nav_inventory_create: '创建资源', inventory_title: '资源清单',
  inventory_resource: '资源', inventory_kind: '类型', inventory_domain: '领域', inventory_role: '角色',
  inventory_lifecycle: '生命周期', inventory_vendor: '厂商', inventory_model: '型号', inventory_software: '软件版本',
  inventory_management_endpoint: '管理端点', inventory_capabilities: '能力集',
  inventory_labels: '标签', inventory_attributes: '扩展属性', inventory_source: '数据来源', inventory_revision: '修订版本',
  inventory_create_resource: '创建资源', inventory_edit_resource: '编辑资源', inventory_retire_resource: '下线资源',
  inventory_name: '名称', inventory_updated_at: '更新时间', saving: '保存中...', retire: '下线',
  brand_alt: 'xCloud 商标', clear: '清除', breadcrumbs_label: '面包屑导航',
  role_admin: '管理员', role_operator: '操作员', role_viewer: '查看员', role_unknown: '未知角色',
  account_settings: '账户设置', nav_system_settings: '系统设置',
  sidebar_filter_ph: '过滤菜单...', sidebar_collapse_hint: '收起导航侧边栏 (Ctrl+B)',
  sidebar_expand_hint: '展开导航侧边栏 (Ctrl+B)',
  notif_center_title: '通知中心', notif_live_stream: '实时流',
  notif_stream_live: '实时', notif_stream_reconnecting: '重连中', notif_tab_all: '全部',
  notif_tab_alerts: '告警', notif_tab_system: '系统', notif_empty: '暂无通知。',
  notif_mark_all_read: '全部标记为已读', notif_clear_all: '全部清除', notif_view_details: '查看详情',
  noc_sentinel: '哨兵', noc_all_clear: '运行正常', noc_all_clear_body: '当前没有上报活跃告警。',
  noc_unavailable: '不可用', noc_unavailable_body: '告警流未连接，因此不推断运行态势。',
  noc_alerts_active: '{count} 条活跃', noc_critical: '严重', noc_warning: '警告', noc_total: '合计',
  alert_acknowledged: '已确认', alert_open: '待处理',
  cp_navigation: '导航', cp_action: '操作', cp_no_results: '没有匹配的目标。',
  cp_hint_navigate: '移动', cp_hint_select: '选择',
  dashboard_eyebrow: '运营驾驶舱', dashboard_live: '实时', dashboard_stale: '已过期',
  dashboard_offline: '离线', dashboard_generated_at: '快照 {time}',
  dashboard_traffic_trend: '流量趋势', dashboard_subscriber_trend: '用户趋势',
  dashboard_plmn_distribution: 'PLMN 分布', dashboard_tariff_distribution: '资费套餐分布',
  dashboard_top_consumers: '流量消耗 Top', dashboard_ocs_balances: 'OCS 余额容量',
  dashboard_ocs_sessions: 'OCS 会话遥测', dashboard_ocs_reservations: 'OCS 预留',
  dashboard_ocs_usage: 'OCS 用量记录', dashboard_kpi_traffic: '总流量',
  dashboard_kpi_subscribers: '用户数', dashboard_kpi_alerts: '活跃告警',
  dashboard_kpi_contracts: 'OCS 合约', dashboard_kpi_active_sessions: '活跃会话',
  dashboard_kpi_utilization: '数据使用率', dashboard_kpi_invariants: '余额不变量',
  dashboard_workbench: '运营优先事项', dashboard_workbench_empty: '暂无紧急事项',
  dashboard_workbench_empty_body: '告警权威当前未上报未确认的告警。',
  dashboard_unavailable: '指标不可用', dashboard_unavailable_body: '当前 API 契约未提供该指标。',
  dashboard_no_series: '无序列数据', dashboard_no_series_body: '当前 API 契约未返回该图表的数据点。',
  dashboard_invariants_ok: '余额不变量全部成立', dashboard_invariants_broken: '{count} 项不变量异常',
  dashboard_allocated: '已分配', dashboard_used: '已使用', dashboard_available: '可用', dashboard_reserved: '预留中',
  dashboard_sessions_total: '会话总数', dashboard_sessions_active: '活跃', dashboard_sessions_closed: '已关闭',
  dashboard_gy_ro: 'Gy / Ro 接口', dashboard_records: '记录数', dashboard_charged_records: '已计费',
  dashboard_orphaned_reservations: '孤儿预留', dashboard_settled_reservations: '已结算',
  error_title: '请求失败', loading_data: '正在加载运营数据...',
  empty_title: '暂无内容', empty_generic_body: '当前 API 契约未返回该视图的数据行。',
  unit_bytes: 'B', unit_records: '条记录', unit_sessions: '个会话', unit_percent: '%',
  inventory_empty_body: '当前筛选条件下没有匹配的资源清单记录。',
  inventory_loading_body: '正在加载资源清单...',
};

export const en: Record<string, string> = { ...LEGACY_EN, ...referenceEn };
export const zh: Record<string, string> = { ...LEGACY_ZH, ...referenceZh };

export const LOCALES: Record<Locale, Record<string, string>> = { en, zh };

export const dictionaries: Record<Locale, Record<string, string>> = LOCALES;
