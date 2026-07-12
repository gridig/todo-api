export const AuditAction = {
  AuthRegister: 'auth.register',
  AuthLogin: 'auth.login',
  AuthTokenInvalid: 'auth.token.invalid',
  AuthNoToken: 'auth.token.missing',
  AuthRefresh: 'auth.refresh',
  AuthLogout: 'auth.logout',
  AuthLogoutAll: 'auth.logout.all',
  // Security event: a revoked refresh token was presented again — treated as
  // token theft, triggering revocation of the user's entire token set.
  AuthRefreshReuse: 'auth.refresh.reuse',

  AccessDenied: 'access.denied',

  // Self-service profile lifecycle (routes/user.ts).
  UserUpdate: 'user.update',
  UserPasswordChange: 'user.password.change',
  UserDelete: 'user.delete',
  UserExport: 'user.export',

  TodoCreate: 'todo.create',
  TodoUpdate: 'todo.update',
  TodoDelete: 'todo.delete',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];
