import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SWRConfig } from 'swr';
import { useBoundedRead } from '../../src/lib/api/use-bounded-read';

function Consumer({scope,name}:{scope:string;name:string}) {
  const read=useBoundedRead<{scope:string}>('/api/bounded-read-fixture?scope='+scope);
  return <output id={name}>{read.error?'error':read.data?.scope||'loading'}</output>;
}
function Fixture() {
  const [scope,setScope]=useState('first');
  const [visible,setVisible]=useState(true);
  const [peer,setPeer]=useState(true);
  return <>
    <button id="next" onClick={()=>setScope('next')}>Next scope</button>
    <button id="slow" onClick={()=>setScope('slow')}>Slow scope</button>
    <button id="toggle" onClick={()=>setVisible(v=>!v)}>Toggle consumers</button>
    <button id="peer" onClick={()=>setPeer(v=>!v)}>Toggle peer</button>
    {visible?<><Consumer scope={scope} name="primary"/>{peer?<Consumer scope={scope} name="secondary"/>:null}</>:null}
  </>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><SWRConfig value={{provider:()=>new Map()}}><Fixture/></SWRConfig></StrictMode>);
