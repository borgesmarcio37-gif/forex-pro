import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// StrictMode removed — causes double renders in dev which triggers double API calls
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
