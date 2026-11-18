export const ACCOUNT_ROUTES = new Map([
  ['/api/health', ['GET']], ['/api/auth/session', ['GET']],
  ['/api/auth/register', ['POST']], ['/api/auth/login', ['POST']],
  ['/api/auth/logout', ['POST']], ['/api/save', ['GET', 'PUT']]
]);
export const validRoute = (path, method) => ACCOUNT_ROUTES.get(path)?.includes(method) === true;
