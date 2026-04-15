import React, { useEffect, useState } from "react";
import axios from "axios";
import MapView from "./MapView";
import Sidebar from "./Sidebar";

function App() {
  const [plots, setPlots] = useState([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    axios.get("http://localhost:5000/plots")
      .then(res => setPlots(res.data));
  }, []);

  const filtered = plots.filter(p =>
    p.plot_no?.toString().includes(search)
  );

  return (
    <div style={{ display: "flex" }}>
      <Sidebar search={search} setSearch={setSearch} plots={filtered} />
      <MapView plots={filtered} />
    </div>
  );
}

export default App;
