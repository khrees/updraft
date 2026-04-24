import { Hono } from 'hono';

const health = new Hono();

health.get('/', (c) => c.json({ success: true, message: 'OK', data: { timestamp: new Date().toISOString() } }));

export default health;
