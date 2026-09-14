const RAW_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/+$/, '');

const HAS_API_SUFFIX = /\/api$/i.test(RAW_URL);
const ROOT_URL = HAS_API_SUFFIX ? RAW_URL.replace(/\/api$/i, '') : RAW_URL;

export const API_URL = RAW_URL;
export const SOCKET_BASE_URL = ROOT_URL; // HTTP/HTTPS base URL for socket.io-client
