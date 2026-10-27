import { useNavigate } from 'react-router-dom'
import VirtualOffice from './VirtualOffice.jsx'

// VirtualOffice stays router-agnostic (several test suites mount it directly),
// so navigation callbacks are injected here instead of through router hooks
// inside the component.
export default function OfficePage() {
  const navigate = useNavigate()

  return (
    <VirtualOffice
      onHome={() => navigate('/')}
      onSettings={() => navigate('/settings')}
      onSignedOut={() => navigate('/login', { replace: true })}
    />
  )
}
