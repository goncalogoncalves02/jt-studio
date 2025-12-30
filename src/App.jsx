import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import NavBar from "./components/NavBar";

function App() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      <NavBar />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          {/* Add other routes here later */}
        </Routes>
      </main>
    </div>
  );
}

export default App;
