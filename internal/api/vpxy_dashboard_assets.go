package api

import (
	"io/fs"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/vpxydash"
	log "github.com/sirupsen/logrus"
)

// registerVPXYDashboardRoutes serves the embedded VPXY dashboard at /management.html and moves
// the upstream management center to /management-center.html. The safe-mode link
// (/management.html?safe-mode=configure) still opens the upstream center, which is where
// api-keys are edited.
func (s *Server) registerVPXYDashboardRoutes() {
	s.engine.GET("/management.html", s.serveVPXYDashboard)
	s.engine.GET("/management-center.html", s.serveManagementControlPanel)
	s.engine.GET("/assets/*filepath", s.serveVPXYDashboardAsset)
}

func (s *Server) serveVPXYDashboard(c *gin.Context) {
	if c.Query("safe-mode") != "" {
		s.serveManagementControlPanel(c)
		return
	}
	if cfg := s.getConfig(); cfg == nil || cfg.Home.Enabled {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	page, err := fs.ReadFile(vpxydash.FS(), "index.html")
	if err != nil {
		log.WithError(err).Error("vpxy dashboard is missing from the build")
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	c.Header("Cache-Control", "no-cache")
	c.Data(http.StatusOK, "text/html; charset=utf-8", page)
}

// serveVPXYDashboardAsset serves the dashboard's content-hashed assets, which never change
// under one name and may be cached for good.
func (s *Server) serveVPXYDashboardAsset(c *gin.Context) {
	name := strings.TrimPrefix(c.Param("filepath"), "/")
	if name == "" || strings.Contains(name, "/") || !fs.ValidPath(name) {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	assets := vpxydash.FS()
	if _, err := fs.Stat(assets, "assets/"+name); err != nil {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFileFS(c.Writer, c.Request, assets, "assets/"+name)
}
