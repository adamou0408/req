import type { ErrorContract, RouteDef } from '../routing/types.ts';
import { errors } from './errors.ts';
import { routes } from './routes.ts';
import { sqlNames, SYSTEM_ACTOR, type SqlNames } from './sqlNames.ts';

export { createSystemCalls } from './systemCalls.ts';
export type { SystemCalls } from './systemCalls.ts';
export type { SqlNames };

export interface Contract {
  routes: RouteDef[];
  errors: ErrorContract;
  sqlNames: SqlNames;
  systemActor: string | null;
}

export const contract: Contract = { routes, errors, sqlNames, systemActor: SYSTEM_ACTOR };

/** 白名單：路由表＋sqlNames 裡出現過的 function 名稱。db 層只肯呼叫這些。 */
export function allowedFunctions(c: Contract): string[] {
  const names = new Set<string>(c.routes.map((r) => r.fn));
  for (const v of Object.values(c.sqlNames)) if (typeof v === 'string') names.add(v);
  return [...names];
}
