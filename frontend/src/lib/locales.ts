import type { Locale } from './preferences';

const en = {
  skip_to_content: 'Skip to content', brand_tagline: 'Subscriber console', sign_in: 'Sign in',
  username: 'Username', password: 'Password', show_password: 'Show password', hide_password: 'Hide password',
  signing_in: 'Signing in...', session_expired: 'Your session has expired. Please sign in again.',
  invalid_credentials: 'Invalid credentials.', rate_limited: 'Too many attempts. Retry after {seconds} seconds.',
  auth_unavailable: 'Authentication service is unavailable.', retry: 'Retry', logout: 'Sign out',
  theme: 'Theme', language: 'Language', system: 'System', light: 'Light', dark: 'Dark',
  navigation: 'Navigation', search_navigation: 'Search navigation', command_palette: 'Command palette',
  close: 'Close', menu: 'Menu', collapse_sidebar: 'Collapse sidebar', expand_sidebar: 'Expand sidebar',
  not_found_title: 'Page not found', not_found_body: 'This route is not part of the SPA migration inventory.',
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
} as const;

const zh: Record<keyof typeof en, string> = {
  skip_to_content: '跳至主要内容', brand_tagline: '用户控制台', sign_in: '登录', username: '用户名', password: '密码',
  show_password: '显示密码', hide_password: '隐藏密码', signing_in: '正在登录...', session_expired: '会话已过期，请重新登录。',
  invalid_credentials: '凭据无效。', rate_limited: '尝试次数过多，请在 {seconds} 秒后重试。', auth_unavailable: '认证服务暂时不可用。',
  retry: '重试', logout: '退出登录', theme: '主题', language: '语言', system: '跟随系统', light: '浅色', dark: '深色',
  navigation: '导航', search_navigation: '搜索导航', command_palette: '命令面板', close: '关闭', menu: '菜单',
  collapse_sidebar: '收起侧边栏', expand_sidebar: '展开侧边栏', not_found_title: '未找到页面',
  not_found_body: '此路由不在 SPA 迁移清单中。', pending_title: '此页面等待迁移',
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
};

export const dictionaries: Record<Locale, Record<string, string>> = { en, zh };
