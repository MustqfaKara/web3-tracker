// Yapilandirilmis loglama: [timestamp] [level] [scope] mesaj
// DEBUG=true ise debug seviyesindeki mesajlar da gosterilir

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function format(level, scope, args) {
  return [`[${ts()}] [${level}] [${scope}]`, ...args];
}

export function createLogger(scope) {
  return {
    info: (...args) => console.log(...format('info', scope, args)),
    warn: (...args) => console.warn(...format('warn', scope, args)),
    error: (...args) => console.error(...format('error', scope, args)),
    debug: (...args) => {
      if (process.env.DEBUG && process.env.DEBUG !== 'false' && process.env.DEBUG !== '0') {
        console.log(...format('debug', scope, args));
      }
    }
  };
}

export const logger = createLogger('app');
