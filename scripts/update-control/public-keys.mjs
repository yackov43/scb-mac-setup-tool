import {createPublicKey} from 'node:crypto';
export function pinnedPublicKey(pem,{allowEmpty=false}={}){
  if(!pem&&allowEmpty)return '';
  if(typeof pem!=='string'||!pem.trim().startsWith('-----BEGIN PUBLIC KEY-----')||pem.includes('PRIVATE'))throw Error('public_trust_key_required');
  const key=createPublicKey(pem);if(key.asymmetricKeyType!=='ed25519')throw Error('ed25519_public_key_required');
  return key.export({type:'spki',format:'pem'});
}
const DEFAULT_RELEASE_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAHcFYdOVomIAi+AGEDDqZ0rTufdWbHUs5ZcEar9vP2Yg=\n-----END PUBLIC KEY-----\n';
const DEFAULT_ACTION_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEASvFTCGgPsb8xYtNst2t+v9YByDxqviFBeMRq3wrp/B4=\n-----END PUBLIC KEY-----\n';

export function buildPublicTrust(env=process.env){
  const allowEmpty=env.SCB_ALLOW_UNTRUSTED_TEST_BUILD==='1';
  const rel = env.SCB_RELEASE_PUBLIC_KEY || DEFAULT_RELEASE_PUBLIC_KEY;
  const act = env.SCB_ACTION_PUBLIC_KEY || DEFAULT_ACTION_PUBLIC_KEY;
  return {release_public_key:pinnedPublicKey(rel,{allowEmpty}),action_public_key:pinnedPublicKey(act,{allowEmpty})};
}
