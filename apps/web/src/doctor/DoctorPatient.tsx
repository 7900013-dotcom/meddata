import { useParams } from "react-router-dom";
import type { RecordRow, Series } from "../api";
import { useLoad } from "../hooks";
import { RecordList } from "../patient/Records";
import { TrendList } from "../patient/Trends";

export function DoctorPatient() {
  const { pid } = useParams();
  const records = useLoad<RecordRow[]>(`/api/doctor/patients/${pid}/records`);
  const trends = useLoad<Series[]>(`/api/doctor/patients/${pid}/trends`);
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Patient records</h1>
          <p className="sub">Shared with you by the patient. Every view is recorded in their access history.</p>
        </div>
      </div>
      {records.error && <p className="alert error">{records.error}</p>}
      {records.data && <RecordList records={records.data} pdfBase={`/api/doctor/patients/${pid}/records/dates`} />}
      {trends.data && trends.data.length > 0 && (
        <>
          <h2 style={{ margin: "28px 0 12px" }}>Trends</h2>
          <TrendList series={trends.data} />
        </>
      )}
    </>
  );
}
