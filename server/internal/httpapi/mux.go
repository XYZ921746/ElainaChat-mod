package httpapi

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"io"
	stdlog "log"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"elainachat/server/internal/auth"
	"elainachat/server/internal/config"
	"elainachat/server/internal/logx"
	"elainachat/server/internal/tlsutil"
)

// Mux 让同一个端口同时认 HTTP 与 HTTPS：地址栏只输 IP 会被浏览器补成 http://，
// 而麦克风只在 https / localhost 下可用。分成两个端口会让用户记两个地址、两条链接各坏一半。
type Mux struct {
	log      *logx.Logger
	auth     *auth.Store
	listener net.Listener

	httpSrv  *http.Server
	httpsSrv *http.Server

	httpCh  chan net.Conn
	httpsCh chan net.Conn

	closeOnce sync.Once
	closed    chan struct{}
}

// 连接级超时：没有它们，一条只发一半请求头的连接可以无限期占住一个 goroutine。
// 不设 WriteTimeout 是刻意的 —— /api/store/stream 是 SSE 长连接，写超时会把正常订阅掐断。
const (
	readHeaderTimeout = 15 * time.Second
	readTimeout       = 5 * time.Minute // 覆盖大备份上传（200MB）在慢速局域网上的耗时
	idleTimeout       = 120 * time.Second
)

func newHTTPServer(handler http.Handler, tlsCfg *tls.Config, quiet *stdlog.Logger) *http.Server {
	return &http.Server{
		Handler:           handler,
		ErrorLog:          quiet,
		TLSConfig:         tlsCfg,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		IdleTimeout:       idleTimeout,
	}
}

// Listen 只预留监听、不开始服务：入口在改密/迁移/打开数据库之前先绑定端口，
// 重复双击的第二个实例在这一步就会失败退出，而不是先改完数据才发现端口被占。
func Listen(cfg *config.Config, log *logx.Logger, port int) (*Mux, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	return &Mux{
		log:      log,
		listener: ln,
		httpCh:   make(chan net.Conn),
		httpsCh:  make(chan net.Conn),
		closed:   make(chan struct{}),
	}, nil
}

// Start 让已预留的监听开始分发请求。证书在这一步才接上：预留阶段不需要它。
func (m *Mux) Start(authStore *auth.Store, handler http.Handler, cert *tlsutil.Info) error {
	m.auth = authStore
	quiet := stdlog.New(io.Discard, "", 0)
	m.httpSrv = newHTTPServer(handler, nil, quiet)
	var tlsCfg *tls.Config
	var err error
	if cert != nil {
		tlsCfg, err = cert.TLSConfig()
		if err != nil {
			_ = m.listener.Close()
			return err
		}
		m.httpsSrv = newHTTPServer(handler, tlsCfg, quiet)
	}

	go func() {
		if serveErr := m.httpSrv.Serve(&chanListener{ch: m.httpCh, closed: m.closed, addr: m.listener.Addr()}); serveErr != nil && !errors.Is(serveErr, net.ErrClosed) {
			m.log.Errorf("HTTP", "HTTP 服务退出：%v", serveErr)
		}
	}()
	if m.httpsSrv != nil {
		go func() {
			if serveErr := m.httpsSrv.Serve(&chanListener{ch: m.httpsCh, closed: m.closed, addr: m.listener.Addr()}); serveErr != nil && !errors.Is(serveErr, net.ErrClosed) {
				m.log.Errorf("Cert", "HTTPS 服务退出：%v", serveErr)
			}
		}()
	}

	go m.acceptLoop(tlsCfg)
	return nil
}

func ListenAndServe(cfg *config.Config, log *logx.Logger, store *auth.Store, handler http.Handler, cert *tlsutil.Info, port int) (*Mux, error) {
	m, err := Listen(cfg, log, port)
	if err != nil {
		return nil, err
	}
	if err := m.Start(store, handler, cert); err != nil {
		_ = m.listener.Close()
		return nil, err
	}
	return m, nil
}

func (m *Mux) acceptLoop(tlsCfg *tls.Config) {
	for {
		conn, err := m.listener.Accept()
		if err != nil {
			select {
			case <-m.closed:
				return
			default:
			}
			m.log.Warnf("HTTP", "接受连接失败：%v", err)
			continue
		}
		// 端口对谁可达由监听地址决定（config.json 的 host，默认只绑回环）：
		// 在无密码时把 host 开到外部是管理人员自己的选择，这里不再按密码状态
		// 销毁连接；设置密码后由鉴权闸门决定能否访问接口。
		go m.dispatch(conn, tlsCfg)
	}
}

// dispatch 看首字节分流：0x16 是 TLS 握手记录。握手失败只丢弃这条连接，
// 不能让一个扫描器把整个监听循环带崩。
func (m *Mux) dispatch(conn net.Conn, tlsCfg *tls.Config) {
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	reader := bufio.NewReader(conn)
	first, err := reader.Peek(1)
	if err != nil {
		_ = conn.Close()
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	pc := &peekedConn{Conn: conn, r: reader}

	if first[0] == 0x16 && tlsCfg != nil {
		tlsConn := tls.Server(pc, tlsCfg)
		select {
		case m.httpsCh <- tlsConn:
		case <-m.closed:
			_ = conn.Close()
		}
		return
	}
	select {
	case m.httpCh <- pc:
	case <-m.closed:
		_ = conn.Close()
	}
}

// Port 返回真实监听端口：服务模式给内核 0 号端口时，端口只有这里知道，
// 要写进 PortFile 交给 Java 服务进程。
func (m *Mux) Port() int {
	if addr, ok := m.listener.Addr().(*net.TCPAddr); ok {
		return addr.Port
	}
	return 0
}

// Shutdown 先关监听再让两个 http.Server 收尾；调用方给一个短超时，
// 卡住的连接不能把退出流程永远拖住。
func (m *Mux) Shutdown(ctx context.Context) error {
	var err error
	m.closeOnce.Do(func() {
		close(m.closed)
		err = m.listener.Close()
	})
	if m.httpSrv != nil {
		_ = m.httpSrv.Shutdown(ctx)
	}
	if m.httpsSrv != nil {
		_ = m.httpsSrv.Shutdown(ctx)
	}
	return err
}

type peekedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *peekedConn) Read(p []byte) (int, error) { return c.r.Read(p) }

type chanListener struct {
	ch     chan net.Conn
	closed chan struct{}
	addr   net.Addr
}

func (l *chanListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.ch:
		if conn == nil {
			return nil, net.ErrClosed
		}
		return conn, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *chanListener) Close() error   { return nil }
func (l *chanListener) Addr() net.Addr { return l.addr }
