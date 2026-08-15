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

  // Email-verification lifecycle. Sent covers both the registration mail and
  // resends; verify records the redemption (success) or a bad/expired/reused
  // token (failure). A login refused for an unverified address is recorded as
  // an auth.login failure with outcomeReason 'email-not-verified'.
  AuthEmailVerificationSent: 'auth.email.verification.sent',
  AuthEmailVerify: 'auth.email.verify',

  AccessDenied: 'access.denied',

  // Self-service profile lifecycle (routes/user.ts).
  UserUpdate: 'user.update',
  UserPasswordChange: 'user.password.change',
  // Email change is a two-step flow: `requested` records the staged address
  // (nothing has moved yet), `change` the redemption that actually moves the
  // account. Both carry blind-index hashes, never raw addresses.
  UserEmailChangeRequested: 'user.email.change.requested',
  UserEmailChange: 'user.email.change',
  UserDelete: 'user.delete',
  UserExport: 'user.export',

  // Administrative actions (routes/admin.ts). Emitted inside $transaction so an
  // audit failure rolls back the privileged action.
  AdminUserRoleChange: 'admin.user.role.change',
  AdminUserDelete: 'admin.user.delete',
  // Operator marked an address verified out-of-band (scripts/verify-email.ts),
  // bypassing the emailed token. Deliberately distinct from auth.email.verify so
  // "the user proved this address" and "an operator asserted it" never blur
  // together in an access review.
  AdminUserEmailVerify: 'admin.user.email.verify',

  TodoCreate: 'todo.create',
  TodoUpdate: 'todo.update',
  TodoDelete: 'todo.delete',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];
