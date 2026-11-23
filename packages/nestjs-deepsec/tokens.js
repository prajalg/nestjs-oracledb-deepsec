'use strict';
const { SetMetadata } = require('@nestjs/common');
const DEEPSEC_POOL = Symbol('DEEPSEC_POOL');
const PUBLIC_ROUTE = Symbol('DEEPSEC_PUBLIC_ROUTE');
const DeepSecPublic = () => SetMetadata(PUBLIC_ROUTE, true);
module.exports = { DEEPSEC_POOL, PUBLIC_ROUTE, DeepSecPublic };
