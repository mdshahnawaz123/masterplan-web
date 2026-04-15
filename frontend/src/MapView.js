import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";

const getColor = (far) => {
  if (far > 6) return "#d73027";
  if (far > 4) return "#fc8d59";
  if (far > 2) return "#fee08b";
  return "#1a9850";
};

export default function MapView({ plots }) {
  return (
    <MapContainer center={[25.1, 55.2]} zoom={13} style={{ height: "100vh", width: "80%" }}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

      {plots.map((p, i) => (
        <CircleMarker
          key={i}
          center={[25.1 + i * 0.001, 55.2 + i * 0.001]}
          radius={8}
          pathOptions={{ color: getColor(p.far) }}
        >
          <Popup>
            <b>Plot:</b> {p.plot_no} <br />
            GFA: {p.gfa} <br />
            FAR: {p.far}
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
