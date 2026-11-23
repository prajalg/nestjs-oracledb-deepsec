import { SetMetadata } from '@nestjs/common';

export const DEEPSEC_POOL = Symbol('DEEPSEC_POOL');
export const PUBLIC_ROUTE = Symbol('DEEPSEC_PUBLIC_ROUTE');
export const DeepSecPublic = (): ClassDecorator & MethodDecorator => SetMetadata(PUBLIC_ROUTE, true);
