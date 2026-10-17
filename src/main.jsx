import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { theme } from './theme.js'
import App from './App.jsx'
import { getConsent, loadAnalytics } from './consent.js'
import { startServiceWorker } from './pwa.js'
import UpdateNotice from './components/UpdateNotice.jsx'
import SaveNotice from './components/SaveNotice.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

// Analytics only for visitors who opted in on the start page (see ConsentBanner).
if (getConsent() === 'granted') loadAnalytics()

// Offline support and the "new version available" notice (see pwa.js).
startServiceWorker()

// Keep the browser's install prompt so the start page can offer "Install as an app".
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  window.__labInstallPrompt = e
  window.dispatchEvent(new Event('lab-install-available'))
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline enableColorScheme />
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
      <UpdateNotice />
      <SaveNotice />
    </ThemeProvider>
  </StrictMode>,
)
