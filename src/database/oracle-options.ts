const required = (name: string) => {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required; see .env.example`);
  return value;
};

// Ordinary Oracle credentials used by this app's pool and standalone connections.
export function oracleConnectionOptions() {
  return {
    user: required('NODE_ORACLEDB_USER'),
    password: required('NODE_ORACLEDB_PASSWORD'),
    connectString: required('NODE_ORACLEDB_CONNECTIONSTRING'),
    walletLocation: process.env.NODE_ORACLEDB_WALLET_LOCATION || undefined,
    walletPassword: process.env.NODE_ORACLEDB_WALLET_PASSWORD || undefined,
    connectTimeout: 10,
  };
}
