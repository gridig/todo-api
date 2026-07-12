import request from 'supertest';
import {
  createTestApp,
  createTestUser,
  connectTestDB,
  disconnectTestDB,
  cleanupTestData,
} from '../../helpers/testSetup.js';

const app = createTestApp();

let authToken: string;

beforeAll(async () => {
  await connectTestDB();
});

beforeEach(async () => {
  ({ authToken } = await createTestUser());
});

afterEach(async () => {
  await cleanupTestData();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('PATCH /user/me', () => {
  it('updates the display name without requiring a password', async () => {
    const res = await request(app)
      .patch('/user/me')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Ada Lovelace' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Ada Lovelace');

    const check = await request(app).get('/user/me').set('Authorization', `Bearer ${authToken}`);
    expect(check.body.name).toBe('Ada Lovelace');
  });

  it('rejects an empty body (name is required) with 400', async () => {
    const res = await request(app)
      .patch('/user/me')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('does not accept an email here (that lives on /user/me/email)', async () => {
    // Unknown fields are stripped, so email alone leaves the body empty → 400.
    const res = await request(app)
      .patch('/user/me')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ email: 'new@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
