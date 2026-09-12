import { createServer } from 'node:net'
import type { ServerOptions } from 'vite'

export async function browserFixtureServerOptions(): Promise<ServerOptions> {
  // Vite treats port 0 as its default port. Ask the OS for an available port first.
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close((error) => {
        if (error) reject(error)
        else if (!address || typeof address === 'string') reject(new Error('Fixture port probe did not expose a TCP address'))
        else resolve(address.port)
      })
    })
  })
  // Allow Vite to try the next port if another process wins the brief handoff race.
  return { host: '127.0.0.1', port, strictPort: false, watch: null }
}
