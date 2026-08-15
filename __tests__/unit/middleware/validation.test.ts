import { schemas } from '@/middleware/validation.js';

describe('Validation Schemas', () => {
  describe('Password Boundaries', () => {
    const validEmail = 'test@example.com';

    it('should reject password with 7 characters', () => {
      const { error } = schemas.register.validate({
        email: validEmail,
        password: 'Short1!',
      });

      expect(error).toBeDefined();
    });

    it('should accept password with 8 characters', () => {
      const { error } = schemas.register.validate({
        email: validEmail,
        password: 'Valid1!a',
      });

      expect(error).toBeUndefined();
    });

    it('should accept password with 72 characters', () => {
      const { error } = schemas.register.validate({
        email: validEmail,
        password: 'A1!' + 'a'.repeat(69),
      });

      expect(error).toBeUndefined();
    });

    it('should reject password with 73 characters', () => {
      const { error } = schemas.register.validate({
        email: validEmail,
        password: 'A1!' + 'a'.repeat(70),
      });

      expect(error).toBeDefined();
    });

    it('should reject password without uppercase letter', () => {
      const { error } = schemas.register.validate({
        email: validEmail,
        password: 'lowercase1!',
      });

      expect(error).toBeDefined();
    });

    it('should reject password without lowercase letter', () => {
      const { error } = schemas.register.validate({
        email: validEmail,
        password: 'UPPERCASE1!',
      });

      expect(error).toBeDefined();
    });

    it('should reject password without number', () => {
      const { error } = schemas.register.validate({
        email: validEmail,
        password: 'NoNumber!a',
      });

      expect(error).toBeDefined();
    });

    it('should reject password without special character', () => {
      const { error } = schemas.register.validate({
        email: validEmail,
        password: 'NoSpecial1a',
      });

      expect(error).toBeDefined();
    });
  });

  describe('Todo Text Boundaries', () => {
    it('should reject empty text', () => {
      const { error } = schemas.todo.validate({ text: '' });

      expect(error).toBeDefined();
    });

    it('should reject whitespace-only text after trim', () => {
      const { error } = schemas.todo.validate({ text: '   ' });

      expect(error).toBeDefined();
    });

    it('should accept text with 1 character', () => {
      const { error } = schemas.todo.validate({ text: 'a' });

      expect(error).toBeUndefined();
    });

    it('should accept text with 500 characters', () => {
      const { error } = schemas.todo.validate({ text: 'a'.repeat(500) });

      expect(error).toBeUndefined();
    });

    it('should reject text with 501 characters', () => {
      const { error } = schemas.todo.validate({ text: 'a'.repeat(501) });

      expect(error).toBeDefined();
    });
  });

  describe('Email Boundaries', () => {
    const validPassword = 'ValidPass1!';

    it('should accept valid email format', () => {
      const { error } = schemas.register.validate({
        email: 'test@example.com',
        password: validPassword,
      });

      expect(error).toBeUndefined();
    });

    it('should reject invalid email format', () => {
      const { error } = schemas.register.validate({
        email: 'invalid-email',
        password: validPassword,
      });

      expect(error).toBeDefined();
    });

    // Length has to come from the domain: Joi's .email() enforces RFC 5321's
    // 64-char local-part limit, so a long local part is rejected as malformed
    // rather than as too long, which would not exercise the cap.
    const EMAIL_254 = `${'a'.repeat(60)}@${'b'.repeat(63)}.${'b'.repeat(63)}.${'b'.repeat(61)}.com`;
    const EMAIL_255 = `${'a'.repeat(60)}@${'b'.repeat(63)}.${'b'.repeat(63)}.${'b'.repeat(62)}.com`;

    it('should accept an address at the RFC 5321 maximum of 254 characters', () => {
      expect(EMAIL_254).toHaveLength(254);
      const { error } = schemas.register.validate({
        email: EMAIL_254,
        password: validPassword,
      });

      expect(error).toBeUndefined();
    });

    it('should reject an address of 255 characters', () => {
      expect(EMAIL_255).toHaveLength(255);
      const { error } = schemas.register.validate({
        email: EMAIL_255,
        password: validPassword,
      });

      expect(error).toBeDefined();
    });

    // Regression: the cap used to be 72 — the bcrypt password limit applied to
    // the wrong field — which rejected ordinary long-but-valid addresses.
    it('should accept an address longer than the old 72-character cap', () => {
      const { error } = schemas.register.validate({
        email: `${'a'.repeat(60)}@${'b'.repeat(40)}.example.com`,
        password: validPassword,
      });

      expect(error).toBeUndefined();
    });

    it('should normalize email to lowercase', () => {
      const { value } = schemas.register.validate({
        email: 'TEST@EXAMPLE.COM',
        password: validPassword,
      });

      expect(value.email).toBe('test@example.com');
    });

    it('should trim email whitespace', () => {
      const { value } = schemas.register.validate({
        email: '  test@example.com  ',
        password: validPassword,
      });

      expect(value.email).toBe('test@example.com');
    });
  });

  describe('UUID Validation', () => {
    it('should accept valid UUID', () => {
      const { error } = schemas.paramsSchema.validate({
        id: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(error).toBeUndefined();
    });

    it('should accept UUID v4 format', () => {
      const { error } = schemas.paramsSchema.validate({
        id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      });

      expect(error).toBeUndefined();
    });

    it('should reject invalid UUID format', () => {
      const { error } = schemas.paramsSchema.validate({
        id: 'not-a-valid-uuid',
      });

      expect(error).toBeDefined();
    });

    it('should reject UUID with wrong length', () => {
      const { error } = schemas.paramsSchema.validate({
        id: '550e8400-e29b-41d4-a716',
      });

      expect(error).toBeDefined();
    });

    it('should reject empty string', () => {
      const { error } = schemas.paramsSchema.validate({
        id: '',
      });

      expect(error).toBeDefined();
    });
  });
});
