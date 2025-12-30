import NavBar from "./components/NavBar";

function App() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      <NavBar />
      <main className="pt-24 px-4 container mx-auto">
        <h1 className="text-4xl font-bold text-brand-dark mb-4">
          Bem-vindo ao JT Studio
        </h1>
        <p className="text-lg text-gray-700">
          O seu espaço de beleza e estética.
        </p>
      </main>
    </div>
  );
}

export default App;
