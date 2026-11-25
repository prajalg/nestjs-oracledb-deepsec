import { SetMetadata } from '@nestjs/common';
import type { DeepSecScopeOptions } from './options';

export const SCOPE = Symbol('DEEPSEC_SCOPE');

/** Enable scope. Optional roles replace mapped roles; Oracle authorizes them.
 * Method metadata overrides the controller. Only trusted app code supplies roles.
 * @example @DeepSec({ dataRoles: ['SALARY_REPORT'] })
 */
export const DeepSec = (options: DeepSecScopeOptions = {}): ClassDecorator & MethodDecorator =>
  SetMetadata(SCOPE, options.dataRoles === undefined ? {} : { dataRoles: [...options.dataRoles] });

/** Skip only this plugin's identity scope. Authentication guards stay active. */
export const SkipDeepSec = (): ClassDecorator & MethodDecorator => SetMetadata(SCOPE, false);
