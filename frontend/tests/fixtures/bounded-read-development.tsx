import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SWRConfig, useSWRConfig } from 'swr';
import { useBoundedRead } from '../../src/lib/api/use-bounded-read';

type Scope = 'first' | 'next' | 'slow' | 'will-fail';

function Consumer({ scope, name }: { scope: Scope; name: string }) {
  const read = useBoundedRead<{ scope: string }>(`/api/bounded-read-fixture?scope=${scope}`);
  const state = read.error ? 'error' : read.data ? 'data' : 'loading';
  return <output id={name} data-state={state} data-validating={read.isValidating ? 'true' : 'false'}>{state === 'data' ? read.data?.scope : state}</output>;
}

function Fixture() {
  const [scope, setScope] = useState<Scope>('first');
  const [primary, setPrimary] = useState(true);
  const [peer, setPeer] = useState(true);
  const { mutate } = useSWRConfig();
  return <>
    <button id="first" onClick={() => setScope('first')}>first</button>
    <button id="next" onClick={() => setScope('next')}>next</button>
    <button id="slow" onClick={() => setScope('slow')}>slow</button>
    <button id="will-fail" onClick={() => setScope('will-fail')}>will fail</button>
    <button id="toggle" onClick={() => setPrimary((value) => !value)}>toggle primary</button>
    <button id="peer" onClick={() => setPeer((value) => !value)}>toggle peer</button>
    <button id="reload" onClick={() => { void mutate(`/api/bounded-read-fixture?scope=${scope}`); }}>reload</button>
    <p id="scope">{scope}</p>
    {primary ? <Consumer scope={scope} name="primary" /> : null}
    {peer ? <Consumer scope={scope} name="secondary" /> : null}
  </>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><SWRConfig value={{ provider: () => new Map() }}><Fixture /></SWRConfig></StrictMode>);