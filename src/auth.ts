import { initializeApp } from 'firebase/app';
import { initializeAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User, browserLocalPersistence } from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = initializeAuth(app, {
  persistence: browserLocalPersistence
});

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/youtube.readonly');
provider.addScope('https://www.googleapis.com/auth/youtube.force-ssl');

export const initAuth = (
  onAuthSuccess?: (user: User) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (onAuthSuccess) onAuthSuccess(user);
    } else {
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to get access token from Firebase Auth');
    }

    // Google OAuth access tokens typically expire in 1 hour (3600 seconds).
    // We save the token and set the expiry to 55 minutes from now to be safe.
    localStorage.setItem('yt_access_token', credential.accessToken);
    localStorage.setItem('yt_token_expiry', (Date.now() + 55 * 60 * 1000).toString());

    return { user: result.user, accessToken: credential.accessToken };
  } catch (error: any) {
    console.error('Sign in error:', error);
    throw error;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  const token = localStorage.getItem('yt_access_token');
  const expiry = localStorage.getItem('yt_token_expiry');
  
  if (token && expiry && Date.now() < Number(expiry)) {
    return token;
  }
  
  // Token expired or not found
  localStorage.removeItem('yt_access_token');
  localStorage.removeItem('yt_token_expiry');
  return null;
};

export const logout = async () => {
  await auth.signOut();
  localStorage.removeItem('yt_access_token');
  localStorage.removeItem('yt_token_expiry');
};
