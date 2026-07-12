import request from 'supertest';
import TodoService from '@/models/Todo.js';
import {
  createTestApp,
  createTestUser,
  connectTestDB,
  disconnectTestDB,
  cleanupTestData,
  truncateAuditEntries,
  pollForAuditRow,
} from '../../helpers/testSetup.js';

const app = createTestApp();

let authToken: string;
let userId: string;

beforeAll(async () => {
  await connectTestDB();
});

beforeEach(async () => {
  ({ authToken, userId } = await createTestUser());
});

afterEach(async () => {
  await cleanupTestData();
  await truncateAuditEntries();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('GET /user/me/export', () => {
  it('exports the profile plus all todos as a JSON attachment and audits it', async () => {
    await TodoService.create({ text: 'first', userId });
    await TodoService.create({ text: 'second', userId });

    const res = await request(app)
      .get('/user/me/export')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain(`todo-api-export-${userId}.json`);

    expect(res.body.user.id).toBe(userId);
    expect(res.body.user.password).toBeUndefined();
    expect(Array.isArray(res.body.todos)).toBe(true);
    expect(res.body.todos).toHaveLength(2);

    const row = await pollForAuditRow('action = $1 AND changed_by = $2', ['user.export', userId]);
    expect(row).not.toBeNull();
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/user/me/export');
    expect(res.status).toBe(401);
  });
});
