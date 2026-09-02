import { useEffect, useState } from 'react';
import { Outlet, useParams } from 'react-router';
import Sidebar from './Sidebar.jsx';
import TopNav from './TopNav.jsx';
import api from '../../lib/axios.js';
import { connectSocket, getSocket } from '../../lib/socket.js';

export default function AppLayout() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);

  useEffect(() => {
    // Connect Socket.io when authenticated inside the app layout
    const socket = connectSocket();

    if (projectId && projectId !== 'new') {
      api
        .get(`/projects/${projectId}`)
        .then((res) => {
          setProject(res.data);
          // Join socket room for this project
          socket.emit('join:project', projectId);
        })
        .catch(() => {
          setProject(null);
        });

      return () => {
        socket.emit('leave:project', projectId);
      };
    } else {
      setProject(null);
    }
  }, [projectId]);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar project={project} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopNav project={project} />
        <main className="flex-1 p-6 md:p-8 max-w-7xl w-full mx-auto">
          <Outlet context={{ project, setProject }} />
        </main>
      </div>
    </div>
  );
}
