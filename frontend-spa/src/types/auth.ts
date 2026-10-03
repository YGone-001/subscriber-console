export type AuthState = 'authenticated' | 'unauthenticated' | 'unavailable';

export type LoginFailure = 'invalid_credentials' | 'rate_limited' | 'service_failure';
