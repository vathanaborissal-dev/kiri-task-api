import { Router } from 'express';
import { csrfProtection } from './middleware/csrf.js';
import { requireAuth } from './middleware/auth.js';
import { requirePasswordChanged } from './middleware/passwordChange.js';
import { activityRouter } from './modules/activity/activity.routes.js';
import { attachmentsRouter } from './modules/attachments/attachments.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { commentsRouter } from './modules/comments/comments.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { filtersRouter } from './modules/filters/filters.routes.js';
import { hotfixesRouter } from './modules/hotfixes/hotfixes.routes.js';
import { issuesRouter } from './modules/issues/issues.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { projectsRouter } from './modules/projects/projects.routes.js';
import { releasesRouter } from './modules/releases/releases.routes.js';
import { rolesRouter } from './modules/roles/roles.routes.js';
import { standupRouter } from './modules/standup/standup.routes.js';
import { tasksRouter } from './modules/tasks/tasks.routes.js';
import { telegramRouter } from './modules/telegram/telegram.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

export const apiRouter = Router();

// The public (pre-session) endpoints live inside authRouter, which turns CSRF
// protection on itself once a session exists.
apiRouter.use('/auth', authRouter);

// Everything below requires a session, and therefore a CSRF token. It also
// requires a password the person chose themselves — the routers below are the
// app proper, and a temporary password should not open any of it.
apiRouter.use(csrfProtection);
apiRouter.use(requireAuth, requirePasswordChanged);

apiRouter.use('/users', usersRouter);
apiRouter.use('/roles', rolesRouter);
apiRouter.use('/projects', projectsRouter);
apiRouter.use('/tasks', tasksRouter);
apiRouter.use('/issues', issuesRouter);
apiRouter.use('/releases', releasesRouter);
apiRouter.use('/hotfixes', hotfixesRouter);
apiRouter.use('/comments', commentsRouter);
apiRouter.use('/attachments', attachmentsRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/activity', activityRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/filters', filtersRouter);
apiRouter.use('/standup', standupRouter);
apiRouter.use('/telegram', telegramRouter);
