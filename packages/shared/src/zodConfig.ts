import { z } from 'zod';

// The page CSP has no 'unsafe-eval'; zod's JIT compiles parsers with `new Function`.
z.config({ jitless: true });
