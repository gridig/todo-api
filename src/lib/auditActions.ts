export const AuditAction = {
  AuthRegister: 'auth.register',
  AuthLogin: 'auth.login',
  AuthTokenInvalid: 'auth.token.invalid',
  AuthNoToken: 'auth.token.missing',

  AccessDenied: 'access.denied',

  TodoCreate: 'todo.create',
  TodoUpdate: 'todo.update',
  TodoDelete: 'todo.delete',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];
