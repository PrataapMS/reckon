import { generateVapidKeys } from '@reckon/adapters';

/** Prints a fresh VAPID key pair for Web Push. Set both in Netlify; rotating them unsubscribes every browser. */
const { publicKey, privateKey } = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}`);
