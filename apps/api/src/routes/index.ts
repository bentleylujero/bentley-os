import { Hono } from 'hono';
import { healthRoute } from './health.js';
import { dashboardRoute } from './dashboard.js';
import { opencodeRoute } from './opencode.js';
import { telegramRoute } from './telegram.js';
import { tasksRoute } from './tasks.js';

export const routes = new Hono();
routes.route('/', healthRoute);
routes.route('/', dashboardRoute);
routes.route('/', opencodeRoute);
routes.route('/', telegramRoute);
routes.route('/', tasksRoute);
