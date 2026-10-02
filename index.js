import { createRuntime } from './src/run.js';

async function bootstrap() {
    while (typeof globalThis.SillyTavern?.getContext !== 'function') await new Promise(resolve => setTimeout(resolve, 100));
    const runtime = createRuntime(() => globalThis.SillyTavern.getContext());
    globalThis.sableEcho = { version: 1, getBanlist: runtime.getBanlist, subscribe: runtime.subscribe };
    try { const { mountDrawer } = await import('./src/ui/drawer.js'); mountDrawer(runtime); } catch { /* Optional until the drawer is installed. */ }
    try { const { mountSettings } = await import('./src/ui/settings.js'); mountSettings(runtime); } catch { /* Optional until settings are installed. */ }
    console.log('[sable-echo] loaded');
}
void bootstrap();
