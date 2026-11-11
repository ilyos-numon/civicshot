import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Capture } from './screens/citizen/Capture.tsx';
import { Confirm } from './screens/citizen/Confirm.tsx';
import { Preview } from './screens/citizen/Preview.tsx';
import { Receipt } from './screens/citizen/Receipt.tsx';
import { Status } from './screens/citizen/Status.tsx';
import { Emergency } from './screens/citizen/Emergency.tsx';
import { Board } from './screens/admin/Board.tsx';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Capture />} />
        <Route path="/confirm" element={<Confirm />} />
        <Route path="/preview" element={<Preview />} />
        <Route path="/receipt/:token" element={<Receipt />} />
        <Route path="/s/:token" element={<Status />} />
        <Route path="/emergency" element={<Emergency />} />
        <Route path="/admin" element={<Board />} />
      </Routes>
    </BrowserRouter>
  );
}
