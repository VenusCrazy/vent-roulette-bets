import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import LandingPage from './pages/LandingPage.jsx'
import AdminPage from './pages/AdminPage.jsx'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <Layout>
              <LandingPage />
            </Layout>
          }
        />
        <Route
          path="/admin"
          element={
            <Layout>
              <AdminPage />
            </Layout>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}