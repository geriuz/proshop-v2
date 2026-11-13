// Prueba de carga variable con k6 (https://k6.io)
// Uso: k6 run -e BASE_URL=https://<tu-app>.azurecontainerapps.io loadtest/carga-variable.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL;
const replicas = new Counter('respuestas_por_replica');

export const options = {
  // Simula un día con tráfico cambiante: calma, pico, meseta, bajada
  stages: [
    { duration: '1m', target: 10 },   // tráfico bajo
    { duration: '2m', target: 100 },  // pico (ej. campaña / Black Friday)
    { duration: '3m', target: 100 },  // meseta sostenida
    { duration: '1m', target: 20 },   // bajada
    { duration: '1m', target: 0 },    // fin
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],     // menos de 1% de errores
    http_req_duration: ['p(95)<800'],   // 95% de respuestas en menos de 800 ms
  },
};

export default function () {
  const res1 = http.get(`${BASE_URL}/api/products?pageNumber=1`);
  check(res1, { 'catálogo 200': (r) => r.status === 200 });
  replicas.add(1, { replica: res1.headers['X-Replica'] || 'desconocida' });

  const res2 = http.get(`${BASE_URL}/api/products/top`);
  check(res2, { 'top productos 200': (r) => r.status === 200 });

  sleep(1);
}
