// src/components/SaveNotice.jsx
// Tells players when the browser couldn't save the session (see autosave.js), since a
// refresh would then lose it. Hides again as soon as a save works.
import React, { useEffect, useState } from "react";
import { Snackbar, Alert } from "@mui/material";
import { onSaveResult } from "../autosave";

export default function SaveNotice() {
  const [failed, setFailed] = useState(false);
  useEffect(() => onSaveResult((ok) => setFailed(!ok)), []);
  return (
    <Snackbar open={failed} anchorOrigin={{ vertical: "bottom", horizontal: "right" }}>
      <Alert severity="warning" variant="filled" onClose={() => setFailed(false)}>
        This browser couldn't save the game (its storage may be full). Avoid refreshing or closing the tab, and send or download the results at the end.
      </Alert>
    </Snackbar>
  );
}
