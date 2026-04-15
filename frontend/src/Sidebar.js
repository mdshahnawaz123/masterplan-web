import axios from "axios";

export default function Sidebar({ search, setSearch, plots }) {

  const totalGFA = plots.reduce((s, p) => s + (p.gfa || 0), 0);

  const uploadExcel = async (e) => {
    const file = e.target.files[0];
    const form = new FormData();
    form.append("file", file);

    await axios.post("http://localhost:5000/upload-excel", form);
    alert("Excel uploaded");
    window.location.reload();
  };

  return (
    <div style={{
      width: "20%",
      padding: "20px",
      background: "#f5f7fa"
    }}>
      <h2>Masterplan Dashboard</h2>

      <input
        placeholder="Search Plot"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: "100%", marginBottom: "10px" }}
      />

      <input type="file" onChange={uploadExcel} />

      <h3>Total GFA</h3>
      <p>{totalGFA.toLocaleString()}</p>
    </div>
  );
}
